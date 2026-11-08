import {
  InvalidToolInputError,
  type ModelMessage,
  type StreamTextTransform,
  type TextStreamPart,
  type ToolSet,
} from "ai";
import { clampErrorMessage, getErrorMessage } from "@/common/utils/errors";
import {
  formatToolInputIssues,
  isToolInputIssueArray,
} from "@/common/utils/tools/formatToolInputIssues";

/** Starts both describeInvalidToolInput's summary and the SDK's own InvalidToolInputError message. */
function invalidToolInputPrefix(toolName: string): string {
  return `Invalid input for tool ${toolName}:`;
}

/**
 * The SDK's InvalidToolInputError message echoes the entire submitted input
 * and buries the zod issue at the end, so the model retries blind. Render only
 * the issues (with received string lengths) when the cause chain
 * (InvalidToolInputError -> TypeValidationError -> ZodError) exposes them.
 */
export function describeInvalidToolInput(toolName: string, input: unknown, error: unknown): string {
  if (InvalidToolInputError.isInstance(error)) {
    let cause: unknown = error.cause;
    for (let depth = 0; depth < 3 && typeof cause === "object" && cause !== null; depth += 1) {
      const issues: unknown = (cause as { issues?: unknown }).issues;
      if (isToolInputIssueArray(issues)) {
        return `${invalidToolInputPrefix(toolName)} ${formatToolInputIssues(issues, input)}`;
      }
      cause = (cause as { cause?: unknown }).cause;
    }
  }
  return clampErrorMessage(getErrorMessage(error));
}

/**
 * streamText transform that rewrites the tool-error of a call the SDK rejected
 * before execution (invalid input) to describeInvalidToolInput's summary.
 *
 * This has to be a stream transform rather than fullStream consumer logic:
 * streamText builds the next step's tool-result message from the transformed
 * stream, so only a transform changes what the model sees on its same-turn
 * retry. The consumer then persists the same summary for later turns.
 */
export function summarizeInvalidToolInputErrors<
  TOOLS extends ToolSet,
>(): StreamTextTransform<TOOLS> {
  return () => {
    const summaries = new Map<string, string>();
    return new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      transform(part, controller) {
        if (
          part.type === "tool-call" &&
          part.dynamic === true &&
          part.invalid === true &&
          part.error != null
        ) {
          summaries.set(
            part.toolCallId,
            describeInvalidToolInput(part.toolName, part.input, part.error)
          );
        } else if (part.type === "tool-error") {
          const summary = summaries.get(part.toolCallId);
          if (summary != null) {
            controller.enqueue({ ...part, error: summary });
            return;
          }
        }
        controller.enqueue(part);
      },
    });
  };
}

function isInvalidToolInputOutput(
  output: { type: string; value?: unknown },
  toolName: string
): boolean {
  const prefix = invalidToolInputPrefix(toolName);
  if (output.type === "error-json" || output.type === "error-text") {
    return typeof output.value === "string" && output.value.startsWith(prefix);
  }
  if (output.type !== "json") return false;
  const value = output.value;
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { success?: unknown }).success === false &&
    typeof (value as { error?: unknown }).error === "string" &&
    (value as { error: string }).error.startsWith(prefix)
  );
}

function collectRejectedToolCallIds(messages: readonly ModelMessage[]): Set<string> {
  const rejected = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && isInvalidToolInputOutput(part.output, part.toolName)) {
        rejected.add(part.toolCallId);
      }
    }
  }
  return rejected;
}

function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

/**
 * Replace the input of every tool call the SDK rejected before execution (its tool-result is an
 * invalid-input error) with `{}`. A rejected call never ran, so replaying its arguments only shows
 * the model a broken shape to copy, and models repeat what they see in their own history; the
 * error result still explains what went wrong. Persisted history keeps the raw input, so the UI
 * still shows what the model sent. Calls that ran and failed are untouched. Returns the same array
 * (and message objects) when nothing changes, keeping the prompt prefix stable across steps.
 */
export function blankInvalidToolCallInputs(messages: ModelMessage[]): ModelMessage[] {
  const rejected = collectRejectedToolCallIds(messages);
  if (rejected.size === 0) return messages;
  let changed = false;
  const result = messages.map((message): ModelMessage => {
    if (message.role !== "assistant" || typeof message.content === "string") return message;
    let messageChanged = false;
    const content = message.content.map((part) => {
      if (
        part.type !== "tool-call" ||
        !rejected.has(part.toolCallId) ||
        isEmptyObject(part.input)
      ) {
        return part;
      }
      messageChanged = true;
      return { ...part, input: {} };
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? result : messages;
}
