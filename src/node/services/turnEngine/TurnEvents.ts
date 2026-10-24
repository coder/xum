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
 * StreamManager still builds the part and stream-start events (emitPartAsEvent,
 * emitStreamStart), records nested tool events (emitNestedToolEvent), appends parts
 * (appendPartAndEmit) and replays streams (replayStream). Each is above the complexity
 * limit for a moved function, so a later layer shrinks it in place first.
 *
 * Invariants:
 * - A non-abort event never rejects into its caller: a failing sink is logged.
 * - An attachment applies once: to its part, else to its nested call (persisting only
 *   the run identity), else to a buffered nested call, else it waits in
 *   pendingWorkflowRunAttachments until appendPartAndEmit takes it.
 */
import type { NestedToolCall } from "@/common/orpc/schemas/message";
import type {
  CompletedMessagePart,
  StreamAbortReason,
  WorkflowRunAttachedEvent,
} from "@/common/types/stream";
import { getErrorMessage } from "@/common/utils/errors";
import { log } from "@/node/services/log";
// Type-only back-edge: the event union and workspace ID brand still live in streamManager.ts.
import type {
  TurnEngineEvent,
  TurnEngineEventSink,
  WorkspaceId,
} from "@/node/services/streamManager";
import { nodeClock } from "@/node/utils/hostClock";

type DynamicToolCompletedMessagePart = Extract<CompletedMessagePart, { type: "dynamic-tool" }>;
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
