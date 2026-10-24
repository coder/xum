/**
 * TurnEvents: the one owner of a StreamManager turn's event delivery (turn-engine
 * layer 4b). It holds the event sink, contains a failing async sink on the
 * fire-and-forget path, awaits stream-abort delivery, builds the re-delivered
 * nested-call event sequence, and owns workflow-run attachments: it applies an
 * attachment to its tool part or nested call, or buffers it until the part lands.
 *
 * Shape: like PartialJournal and UsageLedger, a plain class that StreamManager
 * constructs. The buffers stay on WorkspaceStreamInfo (pendingWorkflowRunAttachments,
 * pendingNestedCalls), because whitebox fixtures hand-build stream infos; StreamManager
 * looks the stream up and passes it in. Generic over the stream type so the partial
 * flush it calls back into gets StreamManager's own stream info.
 *
 * TurnEventEmitter (below) builds the part and stream-start events (emitPartAsEvent,
 * emitStreamStart), records nested tool events (emitNestedToolEvent), appends parts
 * (appendPartAndEmit) and replays streams (replayStream). It is a second class so that
 * TurnEvents keeps its small dependency set; it reads StreamManager's full stream info.
 *
 * Invariants:
 * - A non-abort event never rejects into its caller: a failing sink is logged.
 * - An attachment applies once: to its part, else to its nested call (persisting only
 *   the run identity), else to a buffered nested call, else it waits in
 *   pendingWorkflowRunAttachments until appendPartAndEmit takes it.
 */
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import type { NestedToolCall } from "@/common/orpc/schemas/message";
import type { MCPToolCallDisplay } from "@/common/types/mcp";
import type { MuxMetadata } from "@/common/types/message";
import type {
  CompletedMessagePart,
  StreamAbortReason,
  StreamStartEvent,
  ToolCallExecutionStartEvent,
  UsageDeltaEvent,
  WorkflowRunAttachedEvent,
} from "@/common/types/stream";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { getErrorMessage } from "@/common/utils/errors";
import { eventSpine } from "@/node/services/events/eventSpine";
import { log } from "@/node/services/log";
// Type-only back-edge: the event union, workspace ID brand, stream info and token
// tracker type still live in streamManager.ts.
import type {
  StreamManagerTokenTracker,
  TurnEngineEvent,
  TurnEngineEventSink,
  WorkspaceId,
  WorkspaceStreamInfo,
} from "@/node/services/streamManager";
import type {
  ExecutionScope,
  ToolCallDisplayRegistry,
} from "@/node/services/toolCallDisplayRegistry";
import { markProviderMetadataCostsIncluded } from "@/node/services/turnEngine/UsageLedger";
import { nodeClock } from "@/node/utils/hostClock";

export type DynamicToolCompletedMessagePart = Extract<
  CompletedMessagePart,
  { type: "dynamic-tool" }
>;
export type WorkflowRunToolAttachment = NonNullable<DynamicToolCompletedMessagePart["workflowRun"]>;

/** The stream fields that workflow-run attachments read and buffer on. */
export interface TurnEventsStream {
  readonly messageId: string;
  parts: CompletedMessagePart[];
  pendingWorkflowRunAttachments: Map<string, WorkflowRunToolAttachment>;
  pendingNestedCalls: Map<string, NestedToolCall[]>;
}

export interface TurnEventsDeps<Stream extends TurnEventsStream> {
  /** Writes the stream's partial.json now (StreamManager.flushPartialWrite). */
  readonly flushPartialWrite: (workspaceId: WorkspaceId, streamInfo: Stream) => Promise<void>;
}

export class TurnEvents<Stream extends TurnEventsStream> {
  private eventSink: TurnEngineEventSink;

  constructor(
    eventSink: TurnEngineEventSink,
    private readonly deps: TurnEventsDeps<Stream>
  ) {
    this.eventSink = eventSink;
  }

  setEventSink(eventSink: TurnEngineEventSink): void {
    this.eventSink = eventSink;
  }

  emitTurnEvent(event: TurnEngineEvent): void {
    // TurnEngineEventSink may return a promise; non-abort delivery stays
    // fire-and-forget, so contain rejections here or a failing async sink
    // becomes an unhandled rejection. Abort delivery is sequenced separately
    // via emitStreamAbort.
    void Promise.resolve(this.eventSink(event)).catch((error) => {
      log.error("Turn event sink failed", { eventType: event.type, error: getErrorMessage(error) });
    });
  }

  /** Delivers an event and returns the sink's result, for callers that await or sequence it. */
  deliver(event: TurnEngineEvent): void | Promise<void> {
    return this.eventSink(event);
  }

  async emitStreamAbort(
    workspaceId: WorkspaceId,
    messageId: string,
    metadata: Record<string, unknown>,
    abortReason: StreamAbortReason,
    abandonPartial?: boolean,
    acpPromptId?: string
  ): Promise<void> {
    return Promise.resolve(
      this.eventSink({
        type: "stream-abort",
        workspaceId: workspaceId as string,
        messageId,
        abortReason,
        metadata,
        abandonPartial,
        acpPromptId,
      })
    );
  }

  /**
   * Emit a nested call's full event sequence (start, workflow attachment, end)
   * on behalf of its parent part. Used when the renderer could not have applied
   * the original live events: reconnect replays, and the buffered-merge path in
   * appendPartAndEmit where the original events raced ahead of the parent part.
   * The aggregator dedupes re-delivered nested starts by toolCallId.
   */
  emitNestedCallEvents(
    workspaceId: WorkspaceId,
    messageId: string,
    parentToolCallId: string,
    nestedCalls: NestedToolCall[],
    options: { replay?: boolean; fallbackTimestamp: number }
  ): void {
    const isReplay = options.replay === true;
    for (const nested of nestedCalls) {
      this.emitTurnEvent({
        type: "tool-call-start",
        workspaceId: workspaceId as string,
        messageId,
        ...(isReplay ? { replay: true } : {}),
        toolCallId: nested.toolCallId,
        toolName: nested.toolName,
        args: nested.input ?? {},
        tokens: 0,
        timestamp: nested.timestamp ?? options.fallbackTimestamp,
        parentToolCallId,
      });
      if (nested.workflowRun != null) {
        this.emitTurnEvent({
          type: "workflow-run-attached",
          workspaceId: workspaceId as string,
          messageId,
          ...(isReplay ? { replay: true } : {}),
          toolCallId: nested.toolCallId,
          runId: nested.workflowRun.runId,
          ...(nested.workflowRun.run != null ? { run: nested.workflowRun.run } : {}),
          timestamp: nested.workflowRun.timestamp,
        } satisfies WorkflowRunAttachedEvent);
      }
      if (nested.state === "output-available") {
        this.emitTurnEvent({
          type: "tool-call-end",
          workspaceId: workspaceId as string,
          messageId,
          ...(isReplay ? { replay: true } : {}),
          toolCallId: nested.toolCallId,
          toolName: nested.toolName,
          result: nested.output,
          ...(nested.mcpServer ? { mcpServer: nested.mcpServer } : {}),
          // Record time: wall clock until #7282 moves its consumers to HostClock.
          timestamp: nodeClock.nowMs(),
          parentToolCallId,
        });
      }
    }
  }

  private getWorkflowRunAttachment(event: WorkflowRunAttachedEvent): WorkflowRunToolAttachment {
    return {
      runId: event.runId,
      ...(event.run != null ? { run: event.run } : {}),
      timestamp: event.timestamp,
    };
  }

  takePendingWorkflowRunAttachment(
    streamInfo: Stream,
    toolCallId: string
  ): WorkflowRunToolAttachment | undefined {
    const pendingAttachments = (streamInfo.pendingWorkflowRunAttachments ??= new Map());
    const attachment = pendingAttachments.get(toolCallId);
    if (attachment != null) {
      pendingAttachments.delete(toolCallId);
    }
    return attachment;
  }

  emitWorkflowRunAttachedFromAttachment(input: {
    workspaceId: WorkspaceId;
    messageId: string;
    toolCallId: string;
    attachment: WorkflowRunToolAttachment;
  }): void {
    this.emitTurnEvent({
      type: "workflow-run-attached",
      workspaceId: input.workspaceId as string,
      messageId: input.messageId,
      toolCallId: input.toolCallId,
      runId: input.attachment.runId,
      ...(input.attachment.run != null ? { run: input.attachment.run } : {}),
      timestamp: input.attachment.timestamp,
    } satisfies WorkflowRunAttachedEvent);
  }

  async attachWorkflowRunToToolCall(
    event: WorkflowRunAttachedEvent,
    streamInfo: Stream | undefined
  ): Promise<boolean> {
    const workspaceId = event.workspaceId as WorkspaceId;
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
      // Kernel-launched workflows target a NESTED call persisted on a
      // code_execution part (see emitNestedToolEvent), not a top-level part.
      if (
        await this.attachWorkflowRunToNestedCall(
          workspaceId,
          streamInfo,
          event.toolCallId,
          attachment
        )
      ) {
        return true;
      }
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

    await this.deps.flushPartialWrite(workspaceId, streamInfo);
    return true;
  }

  /**
   * A nested call's persisted attachment keeps only the run identity: the full
   * WorkflowRunRecord carries the workflow source and invocation args, which
   * would ride into partial.json unbounded and defeat the kernel record caps
   * that already replaced the nested args/result with markers. The frontend
   * re-fetches the durable run by runId. (The live workflow-run-attached event
   * still carries the full run snapshot.)
   */
  private static toNestedWorkflowRunAttachment(
    attachment: WorkflowRunToolAttachment
  ): WorkflowRunToolAttachment {
    return { runId: attachment.runId, timestamp: attachment.timestamp };
  }

  /**
   * Persist a workflow run attachment onto the nested call record it targets,
   * so a kernel-launched run's identity survives reload even when kernel
   * bounding replaced the nested args/result with a marker. The live event
   * still reaches the frontend through the normal emit path.
   */
  private async attachWorkflowRunToNestedCall(
    workspaceId: WorkspaceId,
    streamInfo: Stream,
    toolCallId: string,
    attachment: WorkflowRunToolAttachment
  ): Promise<boolean> {
    const nestedAttachment = TurnEvents.toNestedWorkflowRunAttachment(attachment);
    for (const part of streamInfo.parts) {
      if (part.type !== "dynamic-tool") {
        continue;
      }
      const parentPart = part as { nestedCalls?: NestedToolCall[] };
      const nestedCalls = parentPart.nestedCalls;
      const nestedIndex =
        nestedCalls?.findIndex((nested) => nested.toolCallId === toolCallId) ?? -1;
      if (nestedCalls == null || nestedIndex === -1) {
        continue;
      }
      nestedCalls[nestedIndex] = { ...nestedCalls[nestedIndex], workflowRun: nestedAttachment };
      await this.deps.flushPartialWrite(workspaceId, streamInfo);
      return true;
    }
    // The nested record may still be buffered because its parent part has not
    // landed yet; attach there so the merge in appendPartAndEmit persists it.
    for (const buffered of streamInfo.pendingNestedCalls?.values() ?? []) {
      const nestedIndex = buffered.findIndex((nested) => nested.toolCallId === toolCallId);
      if (nestedIndex !== -1) {
        buffered[nestedIndex] = { ...buffered[nestedIndex], workflowRun: nestedAttachment };
        return true;
      }
    }
    return false;
  }
}

/**
 * Model identity persisted/emitted in message and stream metadata. Gateway
 * strings canonicalize for display EXCEPT Coder identities, which stay RAW:
 * name-based canonicalization rewrites a cross-typed instance
 * (coder:openai/<claude>, type anthropic) to openai:<claude>, and usage
 * recovery (WorkspaceStore live deltas, SessionUsageService history rebuilds)
 * re-keys from this metadata via normalizeUsageModelKey — which needs the raw
 * identity to resolve the instance type. Custom-named instances already stay
 * gateway-scoped under normalizeToCanonical, so this only makes
 * canonical-named instances consistent with them.
 */
export function metadataModelIdentity(model: string): string {
  return model.startsWith("coder:") ? model : normalizeToCanonical(model);
}

/** Build a UsageDeltaEvent with consistent costsIncluded stamping on cumulative metadata. */
export function buildUsageDeltaEvent(opts: {
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

/** A tool call that PTC code_execution made, as its kernel reports it. */
export interface NestedToolEvent {
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

/**
 * Apply a nested tool event to its parent's nested-call records (on the parent part, or
 * buffered until it lands): a start adds a record, an end completes the matching one.
 */
export function applyNestedToolEvent(
  nestedCalls: NestedToolCall[],
  event: NestedToolEvent,
  args: unknown,
  mcpServer: MCPToolCallDisplay | undefined
): void {
  if (event.type === "tool-call-start") {
    nestedCalls.push({
      toolCallId: event.callId,
      toolName: event.toolName,
      input: args,
      state: "input-available",
      timestamp: event.startTime,
    });
  } else if (event.type === "tool-call-end") {
    const idx = nestedCalls.findIndex((n) => n.toolCallId === event.callId);
    if (idx !== -1) {
      nestedCalls[idx] = {
        ...nestedCalls[idx],
        output: event.result ?? (event.error ? { error: event.error } : undefined),
        ...(mcpServer ? { mcpServer } : {}),
        state: "output-available",
      };
    }
  }
}

/** What appendPartAndEmit persists for a part, and what raced ahead of a tool part. */
interface ToolPartArrivals {
  partToPersist: CompletedMessagePart;
  pendingAttachment?: WorkflowRunToolAttachment;
  pendingExecutionStart?: number;
  bufferedNestedCalls?: NestedToolCall[];
}

function getStreamMode(initialMetadata?: Partial<MuxMetadata>): "plan" | "exec" | undefined {
  const rawMode = initialMetadata?.mode;
  // Stats schema only accepts "plan" | "exec".
  return rawMode === "plan" || rawMode === "exec" ? rawMode : undefined;
}

/** The stream-start event of a stream: live, or replayed to a reconnecting subscriber. */
export function buildStreamStartEvent(
  workspaceId: WorkspaceId,
  streamInfo: Pick<
    WorkspaceStreamInfo,
    "messageId" | "model" | "metadataModel" | "startTime" | "thinkingLevel" | "initialMetadata"
  >,
  historySequence: number,
  replay: boolean | undefined
): StreamStartEvent {
  const metadata: Partial<MuxMetadata> = streamInfo.initialMetadata ?? {};
  const streamStartAgentId = metadata.agentId;
  const streamStartMode = getStreamMode(streamInfo.initialMetadata);
  const canonicalModel = metadataModelIdentity(streamInfo.model);
  const routeProvider = metadata.routeProvider;

  const event = {
    type: "stream-start",
    workspaceId: workspaceId as string,
    messageId: streamInfo.messageId,
    ...(replay && { replay: true }),
    model: canonicalModel,
    // Request-pinned identity so frontend live pricing/bucketing cannot
    // diverge from the backend ledger when a Coder catalog refresh
    // removes/retags the instance mid-stream.
    metadataModel: streamInfo.metadataModel,
    ...(routeProvider != null && { routeProvider }),
    ...(metadata.autoModelRouting != null && {
      autoModelRouting: metadata.autoModelRouting,
    }),
    historySequence,
    startTime: streamInfo.startTime,
    ...(streamStartAgentId && { agentId: streamStartAgentId }),
    ...(streamStartMode && { mode: streamStartMode }),
    ...(streamInfo.thinkingLevel && { thinkingLevel: streamInfo.thinkingLevel }),
    ...(metadata.acpPromptId != null ? { acpPromptId: metadata.acpPromptId } : {}),
    // The renderer decides at stream start whether this turn belongs in the transcript
    // (a token-budget flush is maintenance output, not an answer), so it needs the turn
    // metadata before the first delta rather than only on stream-end.
    ...(metadata.muxMetadata != null ? { muxMetadata: metadata.muxMetadata } : {}),
  };
  // Kept from the original emit site: thinkingLevel is a plain string on the stream info.
  return event as StreamStartEvent;
}

/**
 * Whether an incremental replay (only what changed after the reconnect cursor) must
 * re-send this part. Missing timestamps replay defensively rather than drop the part.
 */
export function shouldReplayPartAfter(
  part: CompletedMessagePart,
  afterTimestamp: number,
  streamInfo: Pick<WorkspaceStreamInfo, "messageId" | "toolCompletionTimestamps">,
  workspaceId: string
): boolean {
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
    return shouldReplayToolPartAfter(part, afterTimestamp, streamInfo, workspaceId);
  }

  return false;
}

/** The tool-part rules of shouldReplayPartAfter (completion, attachment, nested, execute start). */
function shouldReplayToolPartAfter(
  part: DynamicToolCompletedMessagePart,
  afterTimestamp: number,
  streamInfo: Pick<WorkspaceStreamInfo, "messageId" | "toolCompletionTimestamps">,
  workspaceId: string
): boolean {
  const workflowRunAttachedAt = part.workflowRun?.timestamp;
  if (workflowRunAttachedAt !== undefined && workflowRunAttachedAt > afterTimestamp) {
    return true;
  }

  // Nested kernel calls carry their own activity (start or workflow
  // attach) after the cursor even while the parent part's own
  // timestamps are older; replay the parent so emitPartAsEvent can
  // rebuild the nested rows.
  const nestedCalls = (part as { nestedCalls?: NestedToolCall[] }).nestedCalls ?? [];
  if (
    nestedCalls.some((nested) =>
      nestedCallChangedAfter(nested, afterTimestamp, streamInfo.toolCompletionTimestamps)
    )
  ) {
    return true;
  }

  if (part.state === "output-available") {
    const completionTimestamp = streamInfo.toolCompletionTimestamps.get(part.toolCallId);
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
  if (part.executionStartedAt !== undefined && part.executionStartedAt > afterTimestamp) {
    return true;
  }
  return false;
}

/** A nested call started, got its workflow run, or completed after the cursor. */
function nestedCallChangedAfter(
  nested: NestedToolCall,
  afterTimestamp: number,
  toolCompletionTimestamps: ReadonlyMap<string, number>
): boolean {
  return (
    // Legacy rows can miss the timestamp; replay defensively.
    nested.timestamp === undefined ||
    nested.timestamp > afterTimestamp ||
    (nested.workflowRun != null && nested.workflowRun.timestamp > afterTimestamp) ||
    // The nested record stores no end time, so a call that
    // completed while the renderer was disconnected is only
    // visible through the recorded completion timestamp.
    // Missing entry => replay defensively; re-delivered nested
    // events are deduped by the aggregator.
    (nested.state === "output-available" &&
      (toolCompletionTimestamps.get(nested.toolCallId) ?? Number.POSITIVE_INFINITY) >
        afterTimestamp)
  );
}

/** What TurnEventEmitter reads from StreamManager: its stream lookup, tokenizer and partial writes. */
export interface TurnEventEmitterDeps {
  readonly tokenTracker: StreamManagerTokenTracker;
  readonly toolCallDisplayRegistry: Pick<ToolCallDisplayRegistry, "take">;
  readonly getStream: (workspaceId: WorkspaceId) => WorkspaceStreamInfo | undefined;
  /** Writes the stream's partial.json now (StreamManager.flushPartialWrite). */
  readonly flushPartialWrite: (
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ) => Promise<void>;
  /** Throttled partial.json write (StreamManager.schedulePartialWrite). */
  readonly schedulePartialWrite: (
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo
  ) => Promise<void>;
  /** The #5887 thinking receipt after an Anthropic server tool (StreamManager). */
  readonly turnReplayOffAfterServerTool: (streamInfo: WorkspaceStreamInfo) => void;
}

/**
 * Builds and emits a turn's part, stream-start and nested tool events through TurnEvents,
 * appends parts to the stream, and replays a running stream to a reconnecting subscriber.
 */
export class TurnEventEmitter {
  constructor(
    private readonly turnEvents: TurnEvents<WorkspaceStreamInfo>,
    private readonly deps: TurnEventEmitterDeps
  ) {}

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
    // Record time: wall clock until #7282 moves its consumers to HostClock.
    const timestamp = part.timestamp ?? nodeClock.nowMs();
    const isReplay = options?.replay === true;

    if (part.type === "text") {
      const tokens = await this.deps.tokenTracker.countTokens(part.text);
      this.turnEvents.emitTurnEvent({
        type: "stream-delta",
        workspaceId: workspaceId as string,
        messageId,
        ...(isReplay ? { replay: true } : {}),
        delta: part.text,
        tokens,
        timestamp,
      });
    } else if (part.type === "reasoning") {
      const tokens = await this.deps.tokenTracker.countTokens(part.text);
      this.turnEvents.emitTurnEvent({
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
      await this.emitToolPartAsEvent(workspaceId, messageId, part, isReplay, timestamp);
    }
  }

  /** The tool-part branch of emitPartAsEvent: start, attachment, nested calls, then end. */
  private async emitToolPartAsEvent(
    workspaceId: WorkspaceId,
    messageId: string,
    part: DynamicToolCompletedMessagePart,
    isReplay: boolean,
    timestamp: number
  ): Promise<void> {
    const inputText = JSON.stringify(part.input);
    const tokens = await this.deps.tokenTracker.countTokens(inputText);
    this.turnEvents.emitTurnEvent({
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
      this.turnEvents.emitTurnEvent({
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

    // Replays rebuild renderer state from persisted parts, but nested kernel
    // calls (and their workflow run identities) live on the parent part and
    // are only ever live-emitted by emitNestedToolEvent; without re-emitting
    // them here a reconnect rebuilds the code_execution card without its
    // nested rows. Live appends never carry nestedCalls (buffered nested
    // records merge after this emit), so this only fires on replay in practice.
    const nestedCalls = (part as { nestedCalls?: NestedToolCall[] }).nestedCalls ?? [];
    this.turnEvents.emitNestedCallEvents(workspaceId, messageId, part.toolCallId, nestedCalls, {
      replay: isReplay,
      fallbackTimestamp: timestamp,
    });

    // If tool has output, emit completion
    if (part.state === "output-available") {
      this.turnEvents.emitTurnEvent({
        type: "tool-call-end",
        workspaceId: workspaceId as string,
        messageId,
        ...(isReplay ? { replay: true } : {}),
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        result: part.output,
        ...(part.mcpServer ? { mcpServer: part.mcpServer } : {}),
        // Record time: wall clock until #7282 moves its consumers to HostClock.
        timestamp: nodeClock.nowMs(),
      });
    }
  }

  /**
   * Take what raced ahead of a tool part (a workflow-run attachment, the execute() start,
   * buffered nested calls) and fold it into the part that appendPartAndEmit persists.
   */
  private takeToolPartArrivals(
    streamInfo: WorkspaceStreamInfo,
    part: DynamicToolCompletedMessagePart
  ): ToolPartArrivals {
    const pendingAttachment = this.turnEvents.takePendingWorkflowRunAttachment(
      streamInfo,
      part.toolCallId
    );
    // execute() may have started (lock acquired) before the fullStream consumer
    // stored this part; carry the real execution start onto the persisted part.
    const pendingExecutionStart = streamInfo.pendingToolExecutionStarts?.get(part.toolCallId);
    if (pendingExecutionStart !== undefined) {
      streamInfo.pendingToolExecutionStarts.delete(part.toolCallId);
    }
    // Nested kernel events may have arrived (and been buffered) in the same
    // race window; merge them so they persist with the parent part. Their
    // live events already reached the frontend at emission time.
    const bufferedNestedCalls = streamInfo.pendingNestedCalls?.get(part.toolCallId);
    if (bufferedNestedCalls !== undefined) {
      streamInfo.pendingNestedCalls.delete(part.toolCallId);
    }
    let partToPersist: CompletedMessagePart = part;
    if (
      pendingAttachment != null ||
      pendingExecutionStart !== undefined ||
      bufferedNestedCalls !== undefined
    ) {
      partToPersist = {
        ...part,
        ...(pendingAttachment != null ? { workflowRun: pendingAttachment } : {}),
        ...(pendingExecutionStart !== undefined
          ? { executionStartedAt: pendingExecutionStart }
          : {}),
        ...(bufferedNestedCalls !== undefined ? { nestedCalls: bufferedNestedCalls } : {}),
      };
    }
    return { partToPersist, pendingAttachment, pendingExecutionStart, bufferedNestedCalls };
  }

  async appendPartAndEmit(
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
      const arrivals: ToolPartArrivals =
        part.type === "dynamic-tool"
          ? this.takeToolPartArrivals(streamInfo, part)
          : { partToPersist: part };
      const { partToPersist, pendingAttachment, pendingExecutionStart, bufferedNestedCalls } =
        arrivals;
      streamInfo.parts.push(partToPersist);
      if (part.type === "reasoning") this.deps.turnReplayOffAfterServerTool(streamInfo);
      if (pendingExecutionStart !== undefined && part.type === "dynamic-tool") {
        this.turnEvents.emitTurnEvent({
          type: "tool-call-execution-start",
          workspaceId: workspaceId as string,
          messageId: streamInfo.messageId,
          toolCallId: part.toolCallId,
          timestamp: pendingExecutionStart,
        } satisfies ToolCallExecutionStartEvent);
      }
      if (bufferedNestedCalls !== undefined && part.type === "dynamic-tool") {
        if (pendingAttachment == null) {
          // Buffered nested calls can carry a workflow run identity that must
          // survive an interrupt; don't wait for the debounced write.
          await this.deps.flushPartialWrite(workspaceId, streamInfo);
        }
        // The original nested events raced ahead of the parent part, so the
        // renderer dropped them (it refuses parented events with no parent
        // row); re-deliver them now that the parent start has been emitted.
        this.turnEvents.emitNestedCallEvents(
          workspaceId,
          streamInfo.messageId,
          part.toolCallId,
          bufferedNestedCalls,
          // Record time: wall clock until #7282 moves its consumers to HostClock.
          { fallbackTimestamp: part.timestamp ?? nodeClock.nowMs() }
        );
      }
      if (pendingAttachment != null && part.type === "dynamic-tool") {
        await this.deps.flushPartialWrite(workspaceId, streamInfo);
        this.turnEvents.emitWorkflowRunAttachedFromAttachment({
          workspaceId,
          messageId: streamInfo.messageId,
          toolCallId: part.toolCallId,
          attachment: pendingAttachment,
        });
      } else if (schedulePartialWrite) {
        void this.deps.schedulePartialWrite(workspaceId, streamInfo);
      }
    }
  }

  /**
   * Persist a nested tool event on its parent part, or buffer it until the part lands.
   * Also records a nested completion time for incremental replay.
   */
  private recordNestedToolEvent(
    workspaceId: string,
    streamInfo: WorkspaceStreamInfo,
    event: NestedToolEvent,
    args: unknown,
    mcpServer: MCPToolCallDisplay | undefined
  ): void {
    if (event.type === "tool-call-end") {
      // Nested records never store an end time, so incremental replay needs
      // this to notice a nested call that completed while the renderer was
      // disconnected (same mechanism as top-level tool completions).
      streamInfo.toolCompletionTimestamps.set(
        event.callId,
        // Record time: wall clock until #7282 moves its consumers to HostClock.
        event.endTime ?? nodeClock.nowMs()
      );
    }
    const parentPartIndex = streamInfo.parts.findIndex(
      (p): p is CompletedMessagePart & { type: "dynamic-tool"; toolCallId: string } =>
        p.type === "dynamic-tool" && "toolCallId" in p && p.toolCallId === event.parentToolCallId
    );

    if (parentPartIndex !== -1) {
      const parentPart = streamInfo.parts[parentPartIndex] as { nestedCalls?: NestedToolCall[] };
      const nestedCalls = parentPart.nestedCalls ?? [];

      applyNestedToolEvent(nestedCalls, event, args, mcpServer);

      parentPart.nestedCalls = nestedCalls;

      // Schedule partial write so nested calls survive crashes
      void this.deps.schedulePartialWrite(workspaceId as WorkspaceId, streamInfo);
    } else {
      // execute() can win the race against the fullStream consumer (same window as
      // pendingToolExecutionStarts): buffer the nested record and merge it when the
      // parent part lands, instead of silently dropping it from persistence.
      const pendingNestedCalls = (streamInfo.pendingNestedCalls ??= new Map());
      const buffered = pendingNestedCalls.get(event.parentToolCallId) ?? [];
      applyNestedToolEvent(buffered, event, args, mcpServer);
      pendingNestedCalls.set(event.parentToolCallId, buffered);
    }
  }

  /**
   * Emit nested tool events from PTC code_execution.
   * These are forwarded to the frontend via the same event channel as regular tool events.
   * The parentToolCallId field identifies which code_execution call spawned this nested call.
   *
   * Also persists nested calls to streamInfo.parts so they survive interruption/reload.
   */
  emitNestedToolEvent(scope: ExecutionScope, event: NestedToolEvent): void {
    const { workspaceId, messageId } = scope;
    // Kernel guests can call capabilities with zero arguments. JSON.stringify
    // drops an `args: undefined` key, and the wire schema requires args on
    // tool-call-start, so an unnormalized event would fail oRPC output
    // validation and kill every live onChat subscription. Normalize to {} —
    // the same shape a provider zero-arg tool call carries.
    const args = event.args === undefined ? {} : event.args;

    // Persist nested calls to streamInfo.parts for crash/interrupt resilience.
    // A stale producer may still emit, but must never consume another turn's branding.
    const streamInfo = this.deps.getStream(workspaceId as WorkspaceId);
    const mcpServer =
      event.type === "tool-call-end" && streamInfo?.executionScope === scope
        ? this.deps.toolCallDisplayRegistry.take(scope, event.callId)
        : undefined;
    if (streamInfo) {
      this.recordNestedToolEvent(workspaceId, streamInfo, event, args, mcpServer);
    }

    // Emit to frontend
    if (event.type === "tool-call-start") {
      this.turnEvents.emitTurnEvent({
        type: "tool-call-start",
        workspaceId,
        messageId,
        toolCallId: event.callId,
        toolName: event.toolName,
        args,
        tokens: 0, // Nested calls don't count toward stream tokens
        timestamp: event.startTime,
        parentToolCallId: event.parentToolCallId,
      });
    } else if (event.type === "tool-call-end") {
      this.turnEvents.emitTurnEvent({
        type: "tool-call-end",
        workspaceId,
        messageId,
        toolCallId: event.callId,
        toolName: event.toolName,
        result: event.result ?? (event.error ? { error: event.error } : undefined),
        ...(mcpServer ? { mcpServer } : {}),
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy site from before the ban; remove when touching this line
        timestamp: event.endTime!,
        parentToolCallId: event.parentToolCallId,
      });
    }
    // Console events are not streamed (appear in final result only)
  }

  emitStreamStart(
    workspaceId: WorkspaceId,
    streamInfo: WorkspaceStreamInfo,
    historySequence: number,
    options?: { replay?: boolean }
  ): void {
    this.turnEvents.emitTurnEvent(
      buildStreamStartEvent(workspaceId, streamInfo, historySequence, options?.replay)
    );
    // Lifecycle spine event: skipped on replay — a reconnecting subscriber
    // re-observes an already-running stream, and observers must see exactly
    // one start per stream (paired with the guaranteed end in
    // processStreamWithCleanup's finally).
    if (!options?.replay) {
      eventSpine.emit("stream.start", {
        workspaceId: workspaceId as string,
        messageId: streamInfo.messageId,
      });
    }
  }

  /** The replay of a running stream's events, after StreamManager.replayStream found it running. */
  async replayStream(
    workspaceId: string,
    streamInfo: WorkspaceStreamInfo,
    opts?: { afterTimestamp?: number }
  ): Promise<void> {
    const typedWorkspaceId = workspaceId as WorkspaceId;

    // Initialize token tracker for this model (required for tokenization)
    await this.deps.tokenTracker.setModel(streamInfo.model, streamInfo.metadataModel);

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
        ? replayParts.filter((part) =>
            shouldReplayPartAfter(part, afterTimestamp, streamInfo, workspaceId)
          )
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
        // Replays must preserve costs-included zero-cost behavior from the original stream.
        costsIncluded: streamInfo.initialMetadata?.costsIncluded,
      });
      this.turnEvents.emitTurnEvent(usageEvent);
    }
  }
}
