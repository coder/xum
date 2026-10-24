/**
 * Pure fold of provider stream parts into turn-engine work.
 *
 * StreamManager.processStreamWithCleanup consumes the AI SDK fullStream part by
 * part. For each part, partFold reads a read-only view of the stream state
 * and returns the work as data (FoldIntent[]). It calls
 * nothing: no clock (the caller passes `now`), no I/O, no logging, no mutation.
 * StreamManager.applyStep runs the intents in order with the existing helpers.
 *
 * Why intents instead of new state: appendPartAndEmit must emit a part BEFORE
 * it pushes it to streamInfo.parts (replay dedupe), and in-place reasoning
 * updates must keep their order relative to emits and partial-write scheduling.
 * Both stay ordered side effects, so the fold describes them instead of doing them.
 */
import type {
  CompletedMessagePart,
  ReasoningDeltaEvent,
  ReasoningEndEvent,
} from "@/common/types/stream";
import { extractChunkDeltaText } from "@/common/utils/ai/streamChunks";
import { getErrorMessage } from "@/common/utils/errors";
import {
  readModelOnlyToolNotifications,
  stripInternalToolResultFields,
} from "@/common/utils/tools/internalToolResultFields";
import { stripEncryptedContent } from "@/node/utils/messages/stripEncryptedContent";
import {
  findFirstReasoningPartIndexInTrailingRun,
  mergeReasoningProviderOptions,
  reasoningProviderOptionsFromMetadata,
  type ReasoningProviderMetadata,
} from "@/node/utils/messages/reasoningProviderOptions";

export interface ReasoningDeltaPart {
  type: "reasoning-delta";
  text?: string;
  delta?: string;
  providerMetadata?: ReasoningProviderMetadata;
}

export interface ReasoningLifecyclePart {
  type: "reasoning-start" | "reasoning-end";
  id?: string;
  providerMetadata?: ReasoningProviderMetadata;
}

interface ToolPart {
  toolCallId: string;
  toolName: string;
  providerExecuted?: boolean;
}

/**
 * Any AI SDK fullStream part. foldIntents narrows by `type` and reads each
 * part type's fields, as the inline switch in processStreamWithCleanup did.
 */
export interface FoldablePart {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** Read-only snapshot of the stream state the fold reads. */
export interface FoldView {
  readonly workspaceId: string;
  readonly messageId: string;
  readonly parts: readonly CompletedMessagePart[];
  readonly currentReasoningBlock: { readonly lastPart?: CompletedMessagePart } | undefined;
  readonly lastPartTimestamp: number;
  /** The request runs on the Anthropic Messages wire (server-tool IDs are tracked). */
  readonly anthropicMessagesWire: boolean;
  /** Tool calls of the current attempt, by toolCallId. */
  readonly toolCalls: ReadonlyMap<string, unknown>;
}

type ReasoningPart = Extract<CompletedMessagePart, { type: "reasoning" }>;

export type FoldIntent =
  /** recordStepStart, map the SDK step to its row step, then await the thinking-strip receipt. */
  | { _tag: "StartStep" }
  /** Replace streamInfo.currentReasoningBlock with a new block that has no part yet. */
  | { _tag: "OpenReasoningBlock" }
  /**
   * Await appendPartAndEmit (emit, then push, then schedule a partial write).
   * With trackInBlock, then set the current reasoning block's lastPart to this
   * exact object: signature deltas compare block.lastPart by reference.
   */
  | {
      _tag: "Append";
      part: CompletedMessagePart;
      trackInBlock: boolean;
      /** Tool parts append without scheduling a partial write. */
      skipPartialWrite?: true;
    }
  /**
   * Update the reasoning part at `index` in place (the object keeps its identity):
   * set `signature` when present, replace providerOptions, and with trackInBlock
   * make it the current reasoning block's lastPart.
   */
  | {
      _tag: "UpdateReasoningPart";
      index: number;
      signature: string | undefined;
      providerOptions: ReasoningProviderMetadata | undefined;
      trackInBlock: boolean;
    }
  | { _tag: "Emit"; event: ReasoningDeltaEvent | ReasoningEndEvent }
  /** Fire-and-forget schedulePartialWrite (never awaited). */
  | { _tag: "SchedulePartialWrite" }
  /** Await checkSoftCancelStream. */
  | { _tag: "CheckSoftCancel" }
  /** Await flushPartialWrite. */
  | { _tag: "FlushPartialWrite" }
  /** Await emitToolCallDeltaIfPresent for a part type the fold does not know. */
  | { _tag: "EmitToolCallDelta"; part: FoldablePart }
  /** Track the call in the attempt's tool-call map (and the Anthropic server-tool ID set). */
  | {
      _tag: "RecordToolCall";
      toolCallId: string;
      toolName: string;
      input: unknown;
      anthropicServerTool: boolean;
    }
  /** Set the output on the tracked tool call. */
  | { _tag: "SetToolCallOutput"; toolCallId: string; output: unknown }
  /** Await finishToolCall (complete the tool part, then check for a soft cancel). */
  | {
      _tag: "FinishToolCall";
      toolCallId: string;
      toolName: string;
      output: unknown;
      providerExecuted: boolean | undefined;
      modelOnlyNotifications: string[] | undefined;
    }
  /** Debug-log the call with its JSON input length (JSON.stringify can throw, so the caller runs it). */
  | { _tag: "LogToolCall"; toolName: string; input: unknown }
  /** Count the orphan result and log it (the caller owns the per-turn count). */
  | { _tag: "LogOrphanToolResult"; toolCallId: string; toolName: string; output: unknown }
  /** Log the tool error; the caller picks the level from the abort state. */
  | { _tag: "LogToolError"; toolCallId: string; toolName: string; error: unknown };

/** typeof each text-delta payload key, for the caller's debug log. */
export interface IgnoredTextDelta {
  textType: string;
  deltaType: string;
  textDeltaType: string;
}

export interface FoldStep {
  intents: FoldIntent[];
  /** The caller stores this before it runs the intents. */
  lastPartTimestamp: number;
  /** Set when a text-delta carried a payload that is not a string. */
  ignoredTextDelta?: IgnoredTextDelta;
}

/**
 * Part timestamps stay strictly monotonic per stream: max(now, last + 1). The
 * cursor lets a second timestamp in the same part get last + 1.
 */
interface StampCursor {
  readonly now: number;
  last: number;
}

function stamp(cursor: StampCursor): number {
  cursor.last = cursor.now <= cursor.last ? cursor.last + 1 : cursor.now;
  return cursor.last;
}

export function partFold(view: FoldView, part: FoldablePart, now: number): FoldStep {
  const cursor: StampCursor = { now, last: view.lastPartTimestamp };
  const intents = foldIntents(view, part, cursor);
  const step: FoldStep = { intents, lastPartTimestamp: cursor.last };
  const ignored =
    part.type === "text-delta" && intents.length === 0 ? ignoredTextDelta(part) : null;
  if (ignored != null) {
    step.ignoredTextDelta = ignored;
  }
  return step;
}

function foldIntents(view: FoldView, part: FoldablePart, cursor: StampCursor): FoldIntent[] {
  switch (part.type) {
    case "start-step":
      return [{ _tag: "StartStep" }];
    case "text-delta":
      return foldTextDelta(part, cursor);
    case "reasoning-start":
      return foldReasoningStart(view, part as ReasoningLifecyclePart, cursor);
    case "reasoning-delta":
      return foldReasoningDelta(view, part as ReasoningDeltaPart, cursor);
    case "reasoning-end":
      return foldReasoningEnd(view, part as ReasoningLifecyclePart);
    default:
      return foldToolPart(view, part, cursor);
  }
}

function foldToolPart(view: FoldView, part: FoldablePart, cursor: StampCursor): FoldIntent[] {
  switch (part.type) {
    case "tool-call":
      return foldToolCall(view, part as FoldablePart & ToolPart & { input: unknown }, cursor);
    case "tool-result":
      return foldToolResult(view, part as FoldablePart & ToolPart & { output: unknown });
    // Handle tool-error parts from the stream (AI SDK 5.0+)
    // These are emitted when tool execution fails (e.g., tool doesn't exist)
    case "tool-error":
      return foldToolError(part as FoldablePart & ToolPart & { error: unknown });
    default:
      return [{ _tag: "EmitToolCallDelta", part }];
  }
}

// Providers/SDKs may stream text deltas under different keys.
const TEXT_DELTA_KEYS = ["text", "delta", "textDelta"] as const;

function foldTextDelta(part: Record<string, unknown>, cursor: StampCursor): FoldIntent[] {
  const deltaText = extractChunkDeltaText(part, TEXT_DELTA_KEYS);
  if (deltaText.length === 0) {
    return [];
  }
  // Append each delta as a new part (merging happens at display time)
  const textPart = { type: "text" as const, text: deltaText, timestamp: stamp(cursor) };
  return [{ _tag: "Append", part: textPart, trackInBlock: false }];
}

function ignoredTextDelta(part: Record<string, unknown>): IgnoredTextDelta | null {
  const present = TEXT_DELTA_KEYS.some((key) => part[key] !== undefined);
  return present
    ? {
        textType: typeof part.text,
        deltaType: typeof part.delta,
        textDeltaType: typeof part.textDelta,
      }
    : null;
}

function foldReasoningStart(
  view: FoldView,
  part: ReasoningLifecyclePart,
  cursor: StampCursor
): FoldIntent[] {
  // OpenAI/xAI may attach itemId (and sometimes encrypted content) on start.
  // Stash on the latest reasoning part, or open an empty one for later deltas.
  const startOptions = reasoningProviderOptionsFromMetadata(part.providerMetadata);
  const intents: FoldIntent[] = [{ _tag: "OpenReasoningBlock" }];
  if (startOptions == null) {
    return intents;
  }
  const lastIndex = view.parts.length - 1;
  const lastPart = view.parts[lastIndex];
  // An Anthropic redacted_thinking block is complete at start and replays as
  // its own block: never merge it into earlier reasoning.
  if (startOptions.anthropic?.redactedData == null && lastPart?.type === "reasoning") {
    intents.push(
      {
        _tag: "UpdateReasoningPart",
        index: lastIndex,
        signature: undefined,
        providerOptions: mergeReasoningProviderOptions(lastPart.providerOptions, startOptions),
        trackInBlock: true,
      },
      { _tag: "SchedulePartialWrite" }
    );
    return intents;
  }
  const reasoningPart = {
    type: "reasoning" as const,
    text: "",
    timestamp: stamp(cursor),
    providerOptions: startOptions,
  };
  intents.push({ _tag: "Append", part: reasoningPart, trackInBlock: true });
  return intents;
}

function foldReasoningDelta(
  view: FoldView,
  part: ReasoningDeltaPart,
  cursor: StampCursor
): FoldIntent[] {
  // Anthropic, OpenAI, and xAI stream reasoning content via reasoning-delta.
  const delta = part.text ?? part.delta ?? "";
  const signature = part.providerMetadata?.anthropic?.signature;
  const deltaOptions = reasoningProviderOptionsFromMetadata(part.providerMetadata);

  // Metadata-only deltas (Anthropic signature, OpenAI/xAI itemId) attach to
  // the latest reasoning part without creating a new empty text part.
  if (!delta && (signature || deltaOptions)) {
    return foldReasoningMetadata(view, signature, deltaOptions, cursor);
  }

  // Append each delta as a new part (merging happens at display time)
  // Include providerOptions for SDK compatibility when converting to ModelMessages
  const newPart = {
    type: "reasoning" as const,
    text: delta,
    timestamp: stamp(cursor),
    signature, // May be undefined, will be filled by subsequent signature delta
    providerOptions: deltaOptions,
  };
  return [{ _tag: "Append", part: newPart, trackInBlock: true }];
}

function foldReasoningMetadata(
  view: FoldView,
  signature: string | undefined,
  deltaOptions: ReasoningProviderMetadata | undefined,
  cursor: StampCursor
): FoldIntent[] {
  const lastIndex = view.parts.length - 1;
  const lastPart = view.parts[lastIndex];
  if (signature && !lastPartIsInCurrentBlock(view, lastPart)) {
    // The block has no part yet (empty thinking, only a signature) or
    // the last part belongs to an earlier block: the signature is a
    // block of its own. Attaching it elsewhere would drop this block
    // and overwrite the earlier block's signature.
    const signedPart = {
      type: "reasoning" as const,
      text: "",
      timestamp: stamp(cursor),
      signature,
      providerOptions: deltaOptions,
    };
    return [{ _tag: "Append", part: signedPart, trackInBlock: true }];
  }
  if (lastPart?.type !== "reasoning") {
    return [];
  }
  return attachReasoningMetadata(view, lastIndex, lastPart, signature, deltaOptions, cursor);
}

function lastPartIsInCurrentBlock(
  view: FoldView,
  lastPart: CompletedMessagePart | undefined
): lastPart is ReasoningPart {
  const block = view.currentReasoningBlock;
  // Without a reasoning-start (some normalized streams) the last
  // reasoning part is the only block we know of.
  return lastPart?.type === "reasoning" && (block == null || block.lastPart === lastPart);
}

function attachReasoningMetadata(
  view: FoldView,
  index: number,
  lastPart: ReasoningPart,
  signature: string | undefined,
  deltaOptions: ReasoningProviderMetadata | undefined,
  cursor: StampCursor
): FoldIntent[] {
  const intents: FoldIntent[] = [
    {
      _tag: "UpdateReasoningPart",
      index,
      signature,
      providerOptions: mergeReasoningProviderOptions(
        lastPart.providerOptions,
        deltaOptions ?? (signature ? { anthropic: { signature } } : undefined)
      ),
      trackInBlock: false,
    },
  ];
  // Emit signature update event for Anthropic UI consumers.
  if (signature) {
    intents.push({
      _tag: "Emit",
      event: {
        type: "reasoning-delta",
        workspaceId: view.workspaceId,
        messageId: view.messageId,
        delta: "",
        tokens: 0,
        timestamp: stamp(cursor),
        signature,
      },
    });
  }
  intents.push({ _tag: "SchedulePartialWrite" });
  return intents;
}

function foldReasoningEnd(view: FoldView, part: ReasoningLifecyclePart): FoldIntent[] {
  // xAI (and OpenAI store=false) put reasoningEncryptedContent on reasoning-end.
  // Xum streams reasoning as many tiny delta parts; providers expect one
  // reasoning item with encrypted content. Attach metadata to the first part
  // of the contiguous reasoning run so convertToModelMessages can replay it
  // even if later parts lack providerOptions.
  const endOptions = reasoningProviderOptionsFromMetadata(part.providerMetadata);
  const intents: FoldIntent[] = [];
  const firstIndex = endOptions ? findFirstReasoningPartIndexInTrailingRun(view.parts) : -1;
  const firstPart = view.parts[firstIndex];
  if (firstIndex >= 0 && firstPart?.type === "reasoning") {
    intents.push(
      {
        _tag: "UpdateReasoningPart",
        index: firstIndex,
        signature: undefined,
        providerOptions: mergeReasoningProviderOptions(firstPart.providerOptions, endOptions),
        trackInBlock: false,
      },
      { _tag: "SchedulePartialWrite" }
    );
  }
  intents.push(
    {
      _tag: "Emit",
      event: { type: "reasoning-end", workspaceId: view.workspaceId, messageId: view.messageId },
    },
    { _tag: "CheckSoftCancel" }
  );
  return intents;
}

function foldToolCall(
  view: FoldView,
  part: ToolPart & { input: unknown },
  cursor: StampCursor
): FoldIntent[] {
  // Note: Tool availability is handled by the SDK, which emits tool-error events
  // for unavailable tools. No need to check here.

  // IMPORTANT: Add tool part to streamInfo.parts immediately (not just on completion)
  // This ensures in-progress tool calls are saved to partial.json if stream is interrupted
  const toolPart = {
    type: "dynamic-tool" as const,
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    state: "input-available" as const,
    input: part.input,
    timestamp: stamp(cursor),
  };
  const intents: FoldIntent[] = [
    {
      _tag: "RecordToolCall",
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      input: part.input,
      anthropicServerTool: part.providerExecuted === true && view.anthropicMessagesWire,
    },
    { _tag: "LogToolCall", toolName: part.toolName, input: part.input },
    { _tag: "Append", part: toolPart, trackInBlock: false, skipPartialWrite: true },
  ];
  // CRITICAL: Flush partial immediately for ask_user_question
  // This tool blocks waiting for user input, and if the app restarts during
  // that wait, the partial must be persisted so it can be restored.
  // Without this, the throttled write might not complete before app shutdown.
  if (part.toolName === "ask_user_question") {
    intents.push({ _tag: "FlushPartialWrite" });
  }
  return intents;
}

function foldToolResult(view: FoldView, part: ToolPart & { output: unknown }): FoldIntent[] {
  // Strip encrypted content from web search results before storing
  const output = stripInternalToolResultFields(stripEncryptedContent(part.output));
  const { toolCallId, toolName } = part;
  return [
    view.toolCalls.has(toolCallId)
      ? { _tag: "SetToolCallOutput", toolCallId, output }
      : { _tag: "LogOrphanToolResult", toolCallId, toolName, output },
    {
      _tag: "FinishToolCall",
      toolCallId,
      toolName,
      output,
      providerExecuted: part.providerExecuted,
      // Kept beside the output, so the next turn's rebuild can resend them.
      modelOnlyNotifications: readModelOnlyToolNotifications(part.output),
    },
  ];
}

function foldToolError(part: ToolPart & { error: unknown }): FoldIntent[] {
  const { toolCallId, toolName, error } = part;
  // Format error output. getErrorMessage (not bare JSON.stringify) so a
  // cyclic/BigInt tool-error payload stays a recoverable tool error instead
  // of throwing here and failing the whole stream.
  const output = {
    success: false,
    error:
      typeof error === "string"
        ? error
        : error instanceof Error
          ? error.message
          : getErrorMessage(error),
  };
  return [
    { _tag: "LogToolError", toolCallId, toolName, error },
    {
      _tag: "FinishToolCall",
      toolCallId,
      toolName,
      output,
      providerExecuted: part.providerExecuted,
      modelOnlyNotifications: undefined,
    },
  ];
}
