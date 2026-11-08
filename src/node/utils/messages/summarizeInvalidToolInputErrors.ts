import {
  InvalidToolInputError,
  type ModelMessage,
  type StreamTextTransform,
  type TextStreamPart,
  type ToolResultPart,
  type ToolSet,
} from "ai";
import { z } from "zod";
import { clampErrorMessage, getErrorMessage } from "@/common/utils/errors";
import { isPlainObject } from "@/common/utils/isPlainObject";
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

const FailedToolResultSchema = z.object({ success: z.literal(false), error: z.string() });

/** The error text of a tool-result as replayed: same-turn SDK error output or a persisted result. */
function replayedErrorText(output: ToolResultPart["output"]): string | undefined {
  if (output.type === "error-json" || output.type === "error-text") {
    return typeof output.value === "string" ? output.value : undefined;
  }
  if (output.type !== "json") return undefined;
  const failed = FailedToolResultSchema.safeParse(output.value);
  return failed.success ? failed.data.error : undefined;
}

function collectRejectedToolCallIds(messages: readonly ModelMessage[]): Set<string> {
  const rejected = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (
        part.type === "tool-result" &&
        replayedErrorText(part.output)?.startsWith(invalidToolInputPrefix(part.toolName)) === true
      ) {
        rejected.add(part.toolCallId);
      }
    }
  }
  return rejected;
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
  const result = messages.map((message) => blankRejectedToolCalls(message, rejected));
  return result.some((message, index) => message !== messages[index]) ? result : messages;
}

function blankRejectedToolCalls(
  message: ModelMessage,
  rejected: ReadonlySet<string>
): ModelMessage {
  if (message.role !== "assistant" || typeof message.content === "string") return message;
  const content = message.content.map((part) =>
    part.type === "tool-call" && rejected.has(part.toolCallId) && !isEmptyRecord(part.input)
      ? { ...part, input: {} }
      : part
  );
  return content.some((part, index) => part !== message.content[index])
    ? { ...message, content }
    : message;
}

function isEmptyRecord(value: unknown): boolean {
  return isPlainObject(value) && Object.keys(value).length === 0;
}
