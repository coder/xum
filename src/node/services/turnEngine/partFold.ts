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
  normalizeUsage,
  withCacheWriteMetadata,
  type AiSdkUsageLike,
} from "@/common/utils/tokens/usageHelpers";
import {
  readModelOnlyToolNotifications,
  stripInternalToolResultFields,
} from "@/common/utils/tools/internalToolResultFields";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import { countAnthropicInputTransformations } from "@/node/utils/messages/anthropicInputTransformations";
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
  /** For log fields. */
  readonly model: string;
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
  /** Mark the terminal finish event; each reason is set only when the part had a string. */
  | { _tag: "RecordTerminalFinish"; finishReason?: string; rawFinishReason?: string }
  /** Add the step usage to the stream totals and emit usage-delta with no await between. */
  | {
      _tag: "RecordStepUsage";
      usage: LanguageModelV2Usage;
      providerMetadata: Record<string, unknown> | undefined;
    }
  /** Await recordInFlightSessionUsage. */
  | { _tag: "RecordInFlightUsage" }
  /** Throw this error from the stream loop (an `error` part), as the inline case did. */
  | { _tag: "Fail"; error: Error }
  /** Workspace-logger line. */
  | {
      _tag: "Log";
      level: "debug" | "info" | "warn";
      message: string;
      fields: Record<string, unknown>;
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
      return foldTurnPart(view, part);
  }
}

function foldTurnPart(view: FoldView, part: FoldablePart): FoldIntent[] {
  switch (part.type) {
    // Handle error parts from the stream (e.g., OpenAI context_length_exceeded)
    case "error":
      return [{ _tag: "Fail", error: streamPartError(part.error) }];
    case "start":
    case "text-start":
      return [];
    case "finish":
      return foldFinish(view, part);
    case "finish-step":
      return foldFinishStep(view, part as FoldablePart & FinishStepPart);
    case "text-end":
      return [{ _tag: "CheckSoftCancel" }];
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

/**
 * The Error an `error` part fails the stream with. Error parts are structured
 * errors from the AI SDK; an Error instance is rethrown as-is.
 */
function streamPartError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error !== "object" || error === null) {
    return new Error(String(error));
  }
  const errorObj = error as Record<string, unknown>;
  // Nested error object with message (OpenAI format), then a direct message.
  // Last resort: stringify the error. getErrorMessage guards against
  // cyclic/BigInt payloads and undefined-returning toJSON, where a bare
  // JSON.stringify would throw and replace the provider error with a
  // serialization TypeError.
  const nested = errorObj.error;
  const nestedMessage =
    typeof nested === "object" && nested !== null
      ? (nested as Record<string, unknown>).message
      : undefined;
  const errorMessage =
    typeof nestedMessage === "string"
      ? nestedMessage
      : typeof errorObj.message === "string"
        ? errorObj.message
        : getErrorMessage(errorObj);
  // Preserve original error as cause for debugging
  return Object.assign(new Error(errorMessage), { cause: errorObj });
}

function foldFinish(view: FoldView, part: FoldablePart): FoldIntent[] {
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
  // Treating it as a non-event lets the `!receivedTerminalEvent`
  // branch after the stream loop fire
  // `handleTruncatedStreamCompletion`, which surfaces a
  // retryable `stream_truncated` error instead of silently
  // committing partial output as a normal assistant message.
  if (part.finishReason === "other" && part.rawFinishReason === undefined) {
    // Observability for the unaudited-adapter risk: if a future
    // provider adapter we haven't read source for legitimately
    // emits `(other, undefined)` as a real terminal finish, the
    // discriminator misfires and the user sees a spurious
    // truncated-stream retry. Surface a log so that misfires
    // are diagnosable instead of silent.
    return [
      {
        _tag: "Log",
        level: "warn",
        message: "Treating synthesized-default (other, undefined) finish as truncated stream",
        fields: { messageId: view.messageId, model: view.model },
      },
    ];
  }
  const finish: Extract<FoldIntent, { _tag: "RecordTerminalFinish" }> = {
    _tag: "RecordTerminalFinish",
  };
  if (typeof part.finishReason === "string") finish.finishReason = part.finishReason;
  if (typeof part.rawFinishReason === "string") finish.rawFinishReason = part.rawFinishReason;
  return [finish];
}

interface FinishStepPart {
  usage: AiSdkUsageLike;
  providerMetadata?: Record<string, unknown>;
}

function foldFinishStep(view: FoldView, part: FinishStepPart): FoldIntent[] {
  // Normalize AI SDK 7 nested usage into mux's persisted flat shape,
  // re-injecting Anthropic cache-write tokens into provider metadata.
  const usage = normalizeUsage(part.usage);
  const providerMetadata = withCacheWriteMetadata(part.providerMetadata, part.usage);
  const intents: FoldIntent[] = [];

  // Preserved thinking: report thinking blocks Anthropic dropped for this
  // step. A prefix-binding drop means Xum edited the prompt prefix, which is
  // worth seeing at info; model/account drops and older-account
  // "mismatch allowed" flags are expected noise.
  const inputTransformations = countAnthropicInputTransformations(providerMetadata);
  if (inputTransformations != null) {
    intents.push({
      _tag: "Log",
      level: inputTransformations.dropped.prefix_binding_mismatch > 0 ? "info" : "debug",
      message: "Anthropic dropped or flagged replayed thinking blocks",
      fields: { messageId: view.messageId, model: view.model, ...inputTransformations },
    });
  }
  intents.push(
    { _tag: "RecordStepUsage", usage, providerMetadata },
    { _tag: "RecordInFlightUsage" },
    { _tag: "CheckSoftCancel" }
  );
  return intents;
}
